import * as pulumi from "@pulumi/pulumi";
import * as eks from "@pulumi/eks";
import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";

// Grab some values from the Pulumi configuration (or use default values)
const config = new pulumi.Config();
const minClusterSize = config.getNumber("minClusterSize") || 3;
const maxClusterSize = config.getNumber("maxClusterSize") || 6;
const desiredClusterSize = config.getNumber("desiredClusterSize") || 3;
const eksNodeInstanceType = config.get("eksNodeInstanceType") || "t3.medium";
const vpcNetworkCidr = config.get("vpcNetworkCidr") || "10.0.0.0/16";

const publicSubnetCIDRs: pulumi.Input<string>[] = config.requireObject("publicSubnetCIDRs") || [
    "10.0.0.0/27",
    "10.0.0.32/27"
];


const availabilityZones: pulumi.Input<string>[] = config.requireObject("availabilityZones") || [
    "eu-central-1a",
    "eu-central-1b",
];

// Create a new VPC
const eksVpc = new aws.ec2.Vpc("eks-vpc", {
    enableDnsHostnames: true,
    cidrBlock: vpcNetworkCidr,
});

// Create an Internet Gateway and Route Table for the public subnets
const eksInternetGateway = new aws.ec2.InternetGateway("eks-igw", {
    vpcId: eksVpc.id,
});

const eksRouteTable = new aws.ec2.RouteTable("eks-rt", {
    vpcId: eksVpc.id,
    routes: [{
        cidrBlock: "0.0.0.0/0",
        gatewayId: eksInternetGateway.id,
    }],
});

let publicSubnetIDs: pulumi.Input<string>[] = [];

// Create the public subnets and route table associations
for (let i = 0; i < availabilityZones.length; i++) {
    const publicSubnet = new aws.ec2.Subnet(`eks-public-subnet-${i}`, {
        vpcId: eksVpc.id,
        mapPublicIpOnLaunch: false,
        assignIpv6AddressOnCreation: false,
        cidrBlock: publicSubnetCIDRs[i],
        availabilityZone: availabilityZones[i],
        tags: {
            Name: `eks-public-subnet-${i}`,
        }
    });

    publicSubnetIDs.push(publicSubnet.id);

    new aws.ec2.RouteTableAssociation(`eks-rt-association-${i}`, {
        subnetId: publicSubnet.id,
        routeTableId: eksRouteTable.id,
    });
}


// Create the EKS cluster
const cluster = new eks.Cluster("eks-cluster", {
    vpcId: eksVpc.id,
    privateSubnetIds: publicSubnetIDs,
    instanceType: eksNodeInstanceType,
    desiredCapacity: desiredClusterSize,
    minSize: minClusterSize,
    maxSize: maxClusterSize,
    endpointPrivateAccess: false,
    endpointPublicAccess: true,
    createOidcProvider: true,
    nodeRootVolumeSize: 150,
});

// Export some values for use elsewhere
export const kubeconfig = pulumi.secret(cluster.kubeconfig);

const provider = new k8s.Provider("k8s", {
    kubeconfig: cluster.kubeconfigJson,
    enableServerSideApply: true,
});


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
    version: "3.2.0",
    repositoryOpts: {
        repo: "https://go-skynet.github.io/helm-charts",
    },
    forceUpdate: true,
    namespace: "local-ai",
    createNamespace: true,
    values: {
        deployment: {
            image: {
                repository: "quay.io/go-skynet/local-ai",
                tag: "latest",
            },
            env: {
                debug: "true",
                context_size: 512,
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
                    url: "https://gpt4all.io/models/ggml-gpt4all-j.bin",
                    name: "ggml-gpt4all-j"
                }
            ],
        },
        persistence: {
            models: {
                size: "50Gi",
                storageClass: "gp2",
                accessModes: "ReadWriteOnce"
            },
            output: {
                size: "10Gi",
                storageClass: "gp2",
                accessModes: "ReadWriteOnce"

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

/*
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
*/
