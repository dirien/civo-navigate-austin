import * as pulumi from "@pulumi/pulumi";
import * as awsx from "@pulumi/awsx";
import * as eks from "@pulumi/eks";
import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";
import * as pinecone from "@pinecone-database/pulumi";

// Grab some values from the Pulumi configuration (or use default values)
const config = new pulumi.Config();
const minClusterSize = config.getNumber("minClusterSize") || 3;
const maxClusterSize = config.getNumber("maxClusterSize") || 6;
const desiredClusterSize = config.getNumber("desiredClusterSize") || 3;
const eksNodeInstanceType = config.get("eksNodeInstanceType") || "t3.medium";
const vpcNetworkCidr = config.get("vpcNetworkCidr") || "10.0.0.0/16";

// Create a new VPC
const eksVpc = new awsx.ec2.Vpc("eks-vpc", {
    enableDnsHostnames: true,
    cidrBlock: vpcNetworkCidr,
});

// Create the EKS cluster
const cluster = new eks.Cluster("eks-cluster", {
    // Put the cluster in the new VPC created earlier
    vpcId: eksVpc.vpcId,
    // Public subnets will be used for load balancers
    publicSubnetIds: eksVpc.publicSubnetIds,
    // Private subnets will be used for cluster nodes
    privateSubnetIds: eksVpc.privateSubnetIds,
    // Change configuration values to change any of the following settings
    instanceType: eksNodeInstanceType,
    desiredCapacity: desiredClusterSize,
    minSize: minClusterSize,
    maxSize: maxClusterSize,
    // Do not give the worker nodes public IP addresses
    nodeAssociatePublicIpAddress: false,
    // Change these values for a private cluster (VPN access required)
    endpointPrivateAccess: false,
    endpointPublicAccess: true,
    createOidcProvider: true,
    nodeRootVolumeSize: 150,
});

// Export some values for use elsewhere
export const kubeconfig = cluster.kubeconfig;
export const vpcId = eksVpc.vpcId;

// @ts-ignore
const assumeEBSRolePolicy = pulumi.all([cluster.core.oidcProvider.arn, cluster.core.oidcProvider.url])
    .apply(([arn, url]) =>
        aws.iam.getPolicyDocumentOutput({
            statements: [{
                effect: "Allow",
                actions: ["sts:AssumeRoleWithWebIdentity"],
                principals: [
                    {
                        type: "Federated",
                        identifiers: [
                            arn
                        ],
                    },
                ],
                conditions: [
                    {
                        test: "StringEquals",
                        variable: `${url.replace('https://', '')}:sub`,
                        values: ["system:serviceaccount:kube-system:ebs-csi-controller-sa"],
                    },
                    {
                        test: "StringEquals",
                        variable: `${url.replace('https://', '')}:aud`,
                        values: ["sts.amazonaws.com"],
                    }
                ],
            }],
        })
    );

const ebsRole = new aws.iam.Role("eks-ebsi-role", {
    assumeRolePolicy: assumeEBSRolePolicy.json,
});

const ebsRolePolicy = new aws.iam.RolePolicyAttachment("eks-ebs-role-policy", {
    role: ebsRole,
    policyArn: "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy",
});

const provider = new k8s.Provider("k8s", {
    kubeconfig: cluster.kubeconfigJson,
    enableServerSideApply: true,
});

new k8s.helm.v3.Release("aws-ebs-csi-driver", {
    chart: "aws-ebs-csi-driver",
    version: "2.27.0",
    namespace: "kube-system",
    repositoryOpts: {
        repo: "https://kubernetes-sigs.github.io/aws-ebs-csi-driver",
    },
    values: {
        controller: {
            serviceAccount: {
                annotations: {
                    "eks.amazonaws.com/role-arn": ebsRole.arn,
                }
            }
        }
    }
}, {
    provider: provider,
})


new k8s.helm.v3.Release("local-ai", {
    chart: "local-ai",
    version: "3.1.0",
    repositoryOpts: {
        repo: "https://go-skynet.github.io/helm-charts",
    },
    namespace: "local-ai",
    createNamespace: true,
    values: {
        deployment: {
            image: "quay.io/go-skynet/local-ai:latest",
            env: {
                localai_mmap: "true",
                threads: 4,
                f16: "true",
                debug: "true",
                context_size: 512,
                galleries: '[{"name":"model-gallery", "url":"github:go-skynet/model-gallery/index.yaml"}, {"url": "github:go-skynet/model-gallery/huggingface.yaml","name":"huggingface"}]',
                modelsPath: "/models"
            }
        }, resources: {
            requests: {
                cpu: "8",
                memory: "32Gi"
            }
        },
        models: {
            list: [
                {
                    url: "https://gpt4all.io/models/ggml-gpt4all-j.bin"
                }
            ],
            persistence: {
                pvc: {
                    enabled: true,
                    size: "100Gi",
                    accessModes: [
                        "ReadWriteOnce"
                    ],
                    hostPath: {
                        enabled: false,
                    }
                }
            }
        }
    }
}, {
    provider: provider,
});

new k8s.helm.v3.Release("flowise", {
    chart: "flowise",
    version: "2.5.0",
    repositoryOpts: {
        repo: "https://cowboysysop.github.io/charts/",
    },
    namespace: "flowise",
    createNamespace: true,
}, {
    provider: provider,
});

const iphoneIndex = new pinecone.PineconeIndex("iphone-index", {
    name: "iphone-index",
    metric: pinecone.IndexMetric.Cosine,
    dimension: 384,
    spec: {
        pod: {
            pods: 1,
            podType: "s1.x1",
            environment: "us-east-1-aws",
            shards: 1,
            replicas: 1,
        }
    },
});


/*
const locaAIRepository = new aws.ecr.Repository("local-ai-repository", {
    name: "local-ai-demo",
    forceDelete: true,
});
*/
